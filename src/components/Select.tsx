import {
	Fragment,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './controls.css';

export interface SelectOption {
	value: string;
	label: string;
	color?: string;
	description?: string;
	disabled?: boolean;
	/** Begin a visual group without adding a selectable row. */
	separatorBefore?: boolean;
}

interface Props {
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void;
	id?: string;
	name?: string;
	className?: string;
	disabled?: boolean;
	'aria-label'?: string;
	'aria-labelledby'?: string;
	'aria-describedby'?: string;
	placeholder?: string;
	title?: string;
	leadingIcon?: ReactNode;
	showChevron?: boolean;
}

/** A select-only combobox. Focus stays on the trigger while its listbox is open. */
export default function Select({
	value,
	options,
	onChange,
	id,
	name,
	className = '',
	disabled = false,
	placeholder = 'Choose an option',
	leadingIcon,
	showChevron = true,
	...accessibility
}: Props) {
	const generatedId = useId();
	const controlId = id || `select-${generatedId}`;
	const listId = `${controlId}-listbox`;
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const optionNodes = useRef<(HTMLButtonElement | null)[]>([]);
	const search = useRef({ text: '', time: 0 });
	const scrollActive = useRef(false);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320 });
	const selected = options.find((option) => option.value === value);
	const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
	const firstEnabled = options.findIndex((option) => !option.disabled);

	function show(index = selectedIndex >= 0 ? selectedIndex : firstEnabled) {
		if (disabled || trigger.current?.matches(':disabled') || firstEnabled < 0) return;
		scrollActive.current = true;
		setActive(index);
		setOpen(true);
	}
	function choose(index: number, restoreFocus = true) {
		const option = options[index];
		if (!option || option.disabled || disabled || trigger.current?.matches(':disabled')) return;
		onChange(option.value);
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	}
	function move(direction: number) {
		let index = active;
		for (let count = 0; count < options.length; count++) {
			index = (index + direction + options.length) % options.length;
			if (!options[index].disabled) {
				scrollActive.current = true;
				setActive(index);
				return;
			}
		}
	}
	function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		if (disabled || trigger.current?.matches(':disabled')) return;
		if (event.key === 'Tab') {
			if (open) choose(active, false);
			return;
		}
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			return;
		}
		if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'Enter' || event.key === ' ') {
				if (open) choose(active);
				else show();
			} else if (event.key === 'Home') show(firstEnabled);
			else if (event.key === 'End') {
				show(options.reduce((last, option, index) => (option.disabled ? last : index), -1));
			} else if (!open) show();
			else move(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
		const now = Date.now();
		const text = `${now - search.current.time < 700 ? search.current.text : ''}${event.key.toLocaleLowerCase()}`;
		search.current = { text, time: now };
		const query = text.split('').every((character) => character === text[0]) ? text[0] : text;
		const start = open ? active : selectedIndex;
		for (let count = 1; count <= options.length; count++) {
			const index = (start + count + options.length) % options.length;
			if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(query)) {
				event.preventDefault();
				show(index);
				break;
			}
		}
	}

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			if (!trigger.current || !popup.current) return;
			const bounds = trigger.current.getBoundingClientRect();
			// CSS zoom on an ancestor scales the portal too. Position in its unscaled coordinates.
			const popupBounds = popup.current.getBoundingClientRect();
			const scale = popup.current.offsetWidth ? popupBounds.width / popup.current.offsetWidth : 1;
			const rect = {
				left: bounds.left / scale,
				top: bounds.top / scale,
				bottom: bounds.bottom / scale,
				width: bounds.width / scale,
			};
			const viewportWidth = window.innerWidth / scale;
			const viewportHeight = window.innerHeight / scale;
			const gutter = 8;
			const width = Math.min(Math.max(rect.width, 220), viewportWidth - gutter * 2);
			// Measure at the final width so wrapped options do not leave an oversized gap above.
			popup.current.style.width = `${width}px`;
			const below = viewportHeight - rect.bottom - 6 - gutter;
			const above = rect.top - 6 - gutter;
			const down = below >= Math.min(260, popup.current.scrollHeight) || below >= above;
			const maxHeight = Math.max(40, Math.min(320, down ? below : above));
			const height = Math.min(popup.current.scrollHeight, maxHeight);
			setPosition({
				left: Math.max(gutter, Math.min(rect.left, viewportWidth - width - gutter)),
				top: Math.max(gutter, down ? rect.bottom + 6 : rect.top - height - 6),
				width,
				maxHeight,
			});
		}
		place();
		const reposition = (event: Event) => {
			if (event.target instanceof Node && popup.current?.contains(event.target)) return;
			place();
		};
		window.addEventListener('resize', place);
		window.addEventListener('scroll', reposition, true);
		return () => {
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', reposition, true);
		};
	}, [open, options]);
	useEffect(() => {
		if (!open || !scrollActive.current) return;
		scrollActive.current = false;
		const row = optionNodes.current[active];
		const container = popup.current;
		if (!row || !container) return;
		const bounds = container.getBoundingClientRect();
		const option = row.getBoundingClientRect();
		const scale = container.offsetWidth ? bounds.width / container.offsetWidth : 1;
		if (option.top < bounds.top) container.scrollTop -= (bounds.top - option.top) / scale;
		else if (option.bottom > bounds.bottom)
			container.scrollTop += (option.bottom - bounds.bottom) / scale;
	}, [open, active]);
	useEffect(() => {
		if (!open) return;
		function dismiss(event: Event) {
			const target = event.target;
			if (
				target instanceof Node &&
				!trigger.current?.contains(target) &&
				!popup.current?.contains(target)
			)
				setOpen(false);
		}
		window.addEventListener('pointerdown', dismiss, true);
		window.addEventListener('focusin', dismiss);
		return () => {
			window.removeEventListener('pointerdown', dismiss, true);
			window.removeEventListener('focusin', dismiss);
		};
	}, [open]);
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	return (
		<>
			<button
				{...accessibility}
				id={controlId}
				ref={trigger}
				type="button"
				role="combobox"
				aria-expanded={open}
				data-value={value}
				aria-haspopup="listbox"
				aria-controls={listId}
				aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
				className={`select-trigger ${className}`.trim()}
				disabled={disabled}
				onClick={() => (open ? setOpen(false) : show())}
				onKeyDown={onKeyDown}
			>
				{leadingIcon}
				<span className="select-option-label">
					{selected?.color && (
						<i
							className="select-swatch"
							style={{ backgroundColor: selected.color }}
							aria-hidden="true"
						/>
					)}
					<span>{selected?.label || placeholder}</span>
				</span>
				{showChevron && <ChevronDown size={15} aria-hidden="true" />}
			</button>
			{name && <input type="hidden" name={name} value={value} disabled={disabled} />}
			{open &&
				createPortal(
					<div
						ref={popup}
						id={listId}
						role="listbox"
						aria-labelledby={controlId}
						className="select-popup"
						style={{ ...position, visibility: position.width ? 'visible' : 'hidden' }}
					>
						{options.map((option, index) => (
							<Fragment key={`${option.value}-${index}`}>
								{option.separatorBefore && index > 0 && (
									<div className="select-separator" role="separator" />
								)}
								<button
									ref={(node) => {
										optionNodes.current[index] = node;
									}}
									id={`${listId}-${index}`}
									type="button"
									role="option"
									aria-selected={value === option.value}
									data-value={option.value}
									aria-disabled={option.disabled || undefined}
									tabIndex={-1}
									className={index === active ? 'active' : ''}
									onPointerMove={() => {
										if (!option.disabled) {
											scrollActive.current = false;
											setActive(index);
										}
									}}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => choose(index)}
								>
									<span>
										<span className="select-option-label">
											{option.color && (
												<i
													className="select-swatch"
													style={{ backgroundColor: option.color }}
													aria-hidden="true"
												/>
											)}
											<span>{option.label}</span>
										</span>
										{option.description && <small>{option.description}</small>}
									</span>
									{value === option.value && <Check size={15} aria-hidden="true" />}
								</button>
							</Fragment>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
