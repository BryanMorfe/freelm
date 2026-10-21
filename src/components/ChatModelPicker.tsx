import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Brain, Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { Connection } from '../types';
import {
	availableThinkingModes,
	defaultThinkingMode,
	getModelDefinition,
	isMaximumThinkingMode,
	listModelChoices,
	modelSupports,
	orderThinkingModes,
	type ModelChoice,
} from '../lib/catalog';
import './chat-model-picker.css';

interface Props {
	task?: 'chat' | 'images' | 'videos';
	connection: Connection;
	model: string;
	thinkingMode: string;
	onThinkingMode: (mode: string) => void;
	disabled: boolean;
	onSelect: (model: string) => void;
	onSettings: () => void;
}

type PickerView = 'effort' | 'models' | 'custom';

export default function ChatModelPicker({
	task = 'chat',
	connection,
	model,
	thinkingMode,
	onThinkingMode,
	disabled,
	onSelect,
	onSettings,
}: Props) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<PickerView>('effort');
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const [position, setPosition] = useState({
		left: 0,
		top: 0,
		width: 264,
		maxHeight: 420,
		ready: false,
	});
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const slider = useRef<HTMLInputElement>(null);
	const typeahead = useRef({ text: '', time: 0 });
	const listId = useId();
	const definition = getModelDefinition(connection, model);
	const effectiveThinking =
		task === 'chat' ? thinkingMode || defaultThinkingMode(connection, model) || '' : '';
	const availableModes =
		task === 'chat' ? orderThinkingModes(availableThinkingModes(connection, model)) : [];
	const selectedThinking = availableModes.find((mode) => mode.id === effectiveThinking);
	const effortIndex = availableModes.findIndex((mode) => mode.id === effectiveThinking);
	const knownModels = listModelChoices(connection, task);
	if (
		model &&
		modelSupports(connection, model, task) &&
		!knownModels.some((choice) => choice.id === model)
	)
		knownModels.unshift({ id: model, name: definition?.name || model, definition });
	const term = query.trim();
	const custom =
		term &&
		!getModelDefinition(connection, term) &&
		!knownModels.some((choice) => choice.id === term)
			? term
			: null;
	const choices: ModelChoice[] =
		view === 'custom'
			? [
					...knownModels.filter((choice) =>
						`${choice.id} ${choice.name}`.toLowerCase().includes(term.toLowerCase()),
					),
					...(custom ? [{ id: custom, name: custom }] : []),
				]
			: knownModels;
	const selectedName = definition?.name || model;
	const activeIndex = Math.min(active, Math.max(choices.length - 1, 0));
	const visible = open && !disabled;
	const maximum = isMaximumThinkingMode(selectedThinking);

	function showModels() {
		setQuery('');
		setActive(
			Math.max(
				0,
				knownModels.findIndex((choice) => choice.id === model),
			),
		);
		setView('models');
	}
	function show() {
		setPosition((current) => ({ ...current, ready: false }));
		if (task === 'chat' && model) setView('effort');
		else showModels();
		setOpen(true);
	}
	function close(restoreFocus = false) {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	}
	function choose(value: string) {
		close(true);
		onSelect(value);
	}
	function configure() {
		close();
		onSettings();
	}

	useLayoutEffect(() => {
		if (!visible) return;
		function place(event?: Event) {
			if (event?.target instanceof Node && popup.current?.contains(event.target)) return;
			const element = popup.current!;
			const rect = trigger.current!.getBoundingClientRect();
			const width = Math.min(view === 'custom' ? 300 : 264, window.innerWidth - 24);
			const above = Math.max(0, rect.top - 20);
			const below = Math.max(0, window.innerHeight - rect.bottom - 20);
			const showAbove = above >= Math.min(160, below);
			const maxHeight = Math.min(420, Math.max(80, showAbove ? above : below));
			element.style.width = `${width}px`;
			element.style.maxHeight = `${maxHeight}px`;
			const height = element.getBoundingClientRect().height;
			const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
			const top = Math.max(
				12,
				Math.min(
					showAbove ? rect.top - height - 8 : rect.bottom + 8,
					window.innerHeight - height - 12,
				),
			);
			setPosition((current) =>
				current.ready &&
				current.left === left &&
				current.top === top &&
				current.width === width &&
				current.maxHeight === maxHeight
					? current
					: { left, top, width, maxHeight, ready: true },
			);
		}
		place();
		const observer = new ResizeObserver(() => place());
		observer.observe(popup.current!);
		observer.observe(trigger.current!);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, { capture: true, passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', place, true);
		};
	}, [visible, view, choices.length, availableModes.length]);

	useEffect(() => {
		if (!visible || !position.ready) return;
		if (view === 'custom') search.current?.focus({ preventScroll: true });
		else if (view === 'models') list.current?.focus({ preventScroll: true });
		else if (availableModes.length > 1) slider.current?.focus({ preventScroll: true });
		else popup.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}, [visible, view, availableModes.length, position.ready]);

	useEffect(() => {
		if (!visible) return;
		function outside(event: Event) {
			const target = event.target as Node;
			if (!popup.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
		}
		document.addEventListener('pointerdown', outside);
		document.addEventListener('focusin', outside);
		return () => {
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('focusin', outside);
		};
	}, [visible]);

	useLayoutEffect(() => {
		if (!visible || view === 'effort') return;
		// Scroll only this list for keyboard navigation or opening it. Hover never moves the menu.
		const container = list.current;
		const option = document.getElementById(`${listId}-${activeIndex}`);
		if (!container || !option) return;
		const bounds = container.getBoundingClientRect();
		const row = option.getBoundingClientRect();
		if (row.top < bounds.top) container.scrollTop -= bounds.top - row.top;
		else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
	}, [activeIndex, visible, view, listId, position.ready]);

	function navigate(event: KeyboardEvent) {
		if (event.nativeEvent.isComposing) return;
		let next: number | undefined;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			next = choices.length
				? (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
				: 0;
		} else if (event.key === 'Home' && view === 'models') next = 0;
		else if (event.key === 'End' && view === 'models') next = Math.max(0, choices.length - 1);
		else if (
			(event.key === 'Enter' || (event.key === ' ' && view === 'models')) &&
			choices.length
		) {
			event.preventDefault();
			choose(choices[activeIndex].id);
		} else if (
			view === 'models' &&
			event.key.length === 1 &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			const now = Date.now();
			typeahead.current = {
				text: `${now - typeahead.current.time < 700 ? typeahead.current.text : ''}${event.key}`,
				time: now,
			};
			const match = choices.findIndex((choice) =>
				choice.name.toLowerCase().startsWith(typeahead.current.text.toLowerCase()),
			);
			if (match >= 0) next = match;
		}
		if (next !== undefined) {
			event.preventDefault();
			setActive(next);
		}
	}

	return (
		<>
			<button
				type="button"
				ref={trigger}
				className="composer-model-trigger"
				aria-label={
					task === 'images' ? 'Image model' : task === 'videos' ? 'Video model' : 'Chat model'
				}
				aria-haspopup="dialog"
				aria-expanded={visible}
				aria-controls={visible ? `${listId}-popup` : undefined}
				title={
					model
						? `${model}${effectiveThinking ? ` ${selectedThinking?.name || effectiveThinking}` : ''}`
						: 'Choose a model'
				}
				disabled={disabled}
				onClick={() => (visible ? close() : show())}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						show();
					}
				}}
			>
				<Brain size={18} className="composer-model-icon" aria-hidden="true" />
				<span className="composer-model-name">{selectedName || 'Select model'}</span>
				{effectiveThinking && (
					<span className={`composer-thinking-value${maximum ? ' is-maximum' : ''}`}>
						{selectedThinking?.name || effectiveThinking}
					</span>
				)}
				<ChevronDown size={13} />
			</button>
			{visible &&
				createPortal(
					<div
						ref={popup}
						id={`${listId}-popup`}
						className={`chat-model-popover picker-${view}`}
						data-image-model-popover={task === 'images' ? 'true' : undefined}
						role="dialog"
						aria-label="Choose a model"
						style={{
							left: position.left,
							top: position.top,
							width: position.width,
							maxHeight: position.maxHeight,
							visibility: position.ready ? 'visible' : 'hidden',
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.stopPropagation();
								event.preventDefault();
								if (view === 'custom') showModels();
								else if (view === 'models' && task === 'chat' && model) setView('effort');
								else close(true);
							}
						}}
					>
						{view === 'effort' ? (
							<div className="compact-effort-picker">
								<span className={`effort-label${maximum ? ' is-maximum' : ''}`}>
									{selectedThinking?.name || 'Choose effort'}
								</span>
								<button className="effort-model-more" aria-label="More models" onClick={showModels}>
									<span>{selectedName}</span>
									<ChevronRight size={12} />
								</button>
								{availableModes.length ? (
									<div className="effort-control">
										<input
											ref={slider}
											className="effort-slider"
											type="range"
											aria-label="Thinking mode"
											aria-valuetext={selectedThinking?.name || 'Choose a thinking value'}
											min={0}
											max={Math.max(1, availableModes.length - 1)}
											step={1}
											value={Math.max(0, effortIndex)}
											disabled={availableModes.length === 1}
											style={
												{
													'--effort-fill': `${availableModes.length === 1 ? 100 : (Math.max(0, effortIndex) / (availableModes.length - 1)) * 100}%`,
												} as CSSProperties
											}
											onChange={(event) =>
												onThinkingMode(availableModes[Number(event.target.value)].id)
											}
										/>
										<div className="effort-stops" aria-label="Thinking values">
											{availableModes.map((mode) => (
												<button
													key={mode.id}
													aria-label={mode.name}
													title={mode.name}
													aria-pressed={mode.id === effectiveThinking}
													onClick={() => onThinkingMode(mode.id)}
												>
													<span />
												</button>
											))}
										</div>
									</div>
								) : (
									<div className="thinking-configuration-needed">
										<p>Configure a thinking value for this model.</p>
										<button onClick={configure}>Configure thinking values</button>
									</div>
								)}
							</div>
						) : (
							<>
								{(view === 'custom' || (task === 'chat' && model)) && (
									<button
										className="picker-back"
										aria-label={view === 'custom' ? 'Back to models' : 'Back to thinking effort'}
										onClick={() => (view === 'custom' ? showModels() : setView('effort'))}
									>
										<ArrowLeft size={14} />
									</button>
								)}
								{view === 'custom' && (
									<div className="chat-model-search">
										<input
											ref={search}
											role="combobox"
											aria-label="Search models"
											aria-expanded="true"
											aria-controls={listId}
											aria-autocomplete="list"
											aria-activedescendant={
												choices.length ? `${listId}-${activeIndex}` : undefined
											}
											placeholder="Enter a model ID"
											value={query}
											autoComplete="off"
											spellCheck={false}
											onChange={(event) => {
												setQuery(event.target.value);
												setActive(0);
											}}
											onKeyDown={navigate}
										/>
									</div>
								)}
								<div
									ref={list}
									className="chat-model-options"
									id={listId}
									role="listbox"
									aria-label="Model choices"
									aria-activedescendant={choices.length ? `${listId}-${activeIndex}` : undefined}
									tabIndex={view === 'models' ? 0 : -1}
									onKeyDown={navigate}
								>
									{choices.map(({ id, name }, index) => (
										<button
											type="button"
											key={id}
											id={`${listId}-${index}`}
											className={`chat-model-option${index === activeIndex ? ' is-active' : ''}`}
											role="option"
											data-value={id}
											aria-selected={id === model}
											tabIndex={-1}
											title={name}
											onMouseDown={(event) => event.preventDefault()}
											onClick={() => choose(id)}
										>
											<span>{name}</span>
											{id === model && <Check size={14} />}
										</button>
									))}
									{!choices.length && (
										<div className="chat-model-empty">
											{term && getModelDefinition(connection, term)
												? `This model is disabled or does not support ${task}.`
												: 'Enter a model ID to get started.'}
										</div>
									)}
								</div>
								{view === 'models' && (
									<button
										className="picker-custom-model"
										onClick={() => {
											setQuery('');
											setActive(0);
											setView('custom');
										}}
									>
										Use a model ID…
									</button>
								)}
							</>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}
