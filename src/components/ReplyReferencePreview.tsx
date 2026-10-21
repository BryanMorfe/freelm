import { Quote, X } from 'lucide-react';
import type { ReplyReference } from '../types';
import './reply-reference.css';

export default function ReplyReferencePreview({
	reference,
	onRemove,
}: {
	reference: ReplyReference;
	onRemove?: () => void;
}) {
	return (
		<div
			className={`reply-reference ${onRemove ? 'composer-reply-reference' : 'message-reply-reference'}`}
			aria-label="Replying to selection"
		>
			<Quote size={16} aria-hidden="true" />
			<div className="reply-reference-body">
				<span className="reply-reference-label">Replying to selection</span>
				<div className="reply-reference-text" title={reference.text}>
					{reference.text}
				</div>
			</div>
			{onRemove && (
				<button
					type="button"
					className="icon-button"
					aria-label="Remove reply reference"
					onClick={onRemove}
				>
					<X size={15} />
				</button>
			)}
		</div>
	);
}
