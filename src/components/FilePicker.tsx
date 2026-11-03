import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import Button from './Button';

/** Presentation only: callers retain validation, errors and the save/install boundary. */
export default function FilePicker({
	label,
	accept,
	disabled,
	onFile,
	describedBy,
	buttonLabel = 'Choose file…',
	busyLabel = 'Processing…',
}: {
	label: string;
	accept: string;
	disabled?: boolean;
	describedBy?: string;
	buttonLabel?: string;
	busyLabel?: string;
	onFile: (file: File) => Promise<void>;
}) {
	const input = useRef<HTMLInputElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const restoreFocus = useRef(false);
	const processing = useRef(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (busy || disabled || !restoreFocus.current) return;
		restoreFocus.current = false;
		// A disabled button loses focus while processing. Restore it only if the
		// person hasn't moved to another control, and never after this picker unmounts.
		if (document.activeElement === document.body) button.current?.focus();
	}, [busy, disabled]);
	return (
		<div className="ui-file-picker">
			<input
				ref={input}
				hidden
				type="file"
				accept={accept}
				aria-label={label}
				disabled={disabled || busy}
				onChange={async (event) => {
					const file = event.currentTarget.files?.[0];
					// Reset before awaiting so the same file can be selected after success or failure.
					event.currentTarget.value = '';
					if (!file || processing.current || disabled) return;
					restoreFocus.current =
						document.activeElement === button.current || document.activeElement === document.body;
					processing.current = true;
					setBusy(true);
					try {
						await onFile(file);
					} finally {
						processing.current = false;
						setBusy(false);
					}
				}}
			/>
			<Button
				ref={button}
				size="compact"
				disabled={disabled}
				busy={busy}
				aria-label={`${busy ? busyLabel : buttonLabel} ${label}`}
				aria-describedby={describedBy}
				onClick={() => input.current?.click()}
			>
				<FileUp size={16} aria-hidden="true" />
				{busy ? busyLabel : buttonLabel}
			</Button>
			<span className="ui-file-picker-status" role="status">
				{busy ? busyLabel : ''}
			</span>
		</div>
	);
}
