import type { ComputerStatus } from '../computer-types';

/** Environment failures are temporary desktop conditions, not permission denials. */
export function computerEnvironmentIssue(status?: ComputerStatus) {
	if (status?.screenLocked === true)
		return {
			title: 'Mac is locked',
			message: 'The Mac is locked. Unlock it, then observe the authorized app again.',
		};
	if (status?.sessionActive === false)
		return {
			title: 'User session is inactive',
			message:
				'This macOS user session is not active. Switch back to this user session, then observe the authorized app again.',
		};
	if (status?.displaysAwake === false)
		return {
			title: 'Displays are asleep',
			message:
				'All connected displays are asleep. Wake a display, then observe the authorized app again.',
		};
	return undefined;
}

export function computerReady(status?: ComputerStatus) {
	return !!(
		status?.available &&
		status.accessibility &&
		status.screenRecording &&
		!computerEnvironmentIssue(status)
	);
}
