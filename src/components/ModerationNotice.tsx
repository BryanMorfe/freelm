import { userFacingError } from '../lib/user-facing-error';
import { TriangleAlert } from 'lucide-react';
import { validModerationWarnings } from '../lib/moderation-warnings';
import './moderation-notice.css';

export default function ModerationNotice({ warnings }: { warnings?: string[] }) {
	if (!validModerationWarnings(warnings) || !warnings.length) return null;
	return (
		<div className="moderation-notice" role="status" aria-label="Moderation warning">
			<TriangleAlert size={15} aria-hidden="true" />
			<div>
				{[...new Set(warnings)].map((warning) => (
					<p key={warning}>{userFacingError(warning)}</p>
				))}
			</div>
		</div>
	);
}
