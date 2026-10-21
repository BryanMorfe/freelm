import { memo, useEffect, useState } from 'react';
import { formatActivityDuration } from '../lib/message-activity';
import './working-status.css';

/** Its clock never updates the chat, message list, or persisted workspace. */
export default memo(function WorkingStatus({
	startedAt = 0,
	header = false,
}: {
	startedAt?: number;
	header?: boolean;
}) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		setNow(Date.now());
		if (header) {
			const timer = setInterval(() => setNow(Date.now()), 1000);
			return () => clearInterval(timer);
		}
	}, [startedAt, header]);
	return (
		<div
			className={header ? 'working-section-header' : 'working-status'}
			role="status"
			aria-label={header ? 'Working on response' : 'Thinking'}
			aria-live="off"
		>
			<span className={header ? undefined : 'activity-shimmer'}>
				{header ? `Working for ${formatActivityDuration(now - startedAt)}` : 'Thinking'}
			</span>
		</div>
	);
});
