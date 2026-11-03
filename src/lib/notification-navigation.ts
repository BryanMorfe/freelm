import { validNotificationDestination, type NotificationDestination } from '../notification-types';
import type { InstanceOverview } from '../remote-types';
export function notificationWorkspace(
	destination: NotificationDestination,
	overview: InstanceOverview,
): string {
	if (!validNotificationDestination(destination))
		throw new Error('This notification has an invalid destination.');
	const actual =
		destination.workspaceId === 'local'
			? overview.host.instanceId
			: overview.instances.find((x) => x.id === destination.workspaceId)?.instanceId;
	if (!actual || actual !== destination.hostId)
		throw new Error(
			'The computer for this notification was removed or changed. Reconnect it before opening the result.',
		);
	if (destination.kind === 'workflow' && destination.workspaceId !== 'local')
		throw new Error('Open this workflow on its owning computer.');
	return destination.workspaceId;
}
