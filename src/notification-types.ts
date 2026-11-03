export interface NotificationDestination {
	hostId: string;
	workspaceId: string;
	kind: 'thread' | 'bot' | 'workflow';
	entityId: string;
	/** Workflow run or completed message identity, never a display title. */
	runId: string;
}
export interface CompletionEvent {
	destination: NotificationDestination;
	outcome: 'completed' | 'failed' | 'cancelled';
	title: string;
	/** Explicit scheduled work keeps its existing foreground notification policy. */
	scheduled?: boolean;
}
export interface BotResponseSound {
	muted: boolean;
	volume: number;
}
export const defaultBotResponseSound: BotResponseSound = { muted: false, volume: 1 };
export function validBotResponseSound(value: unknown): value is BotResponseSound {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const v = value as BotResponseSound;
	return (
		Object.keys(v).every((k) => k === 'muted' || k === 'volume') &&
		typeof v.muted === 'boolean' &&
		typeof v.volume === 'number' &&
		Number.isFinite(v.volume) &&
		v.volume >= 0 &&
		v.volume <= 1
	);
}
export function validNotificationDestination(value: unknown): value is NotificationDestination {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const v = value as NotificationDestination;
	return (
		['thread', 'bot', 'workflow'].includes(v.kind) &&
		[v.hostId, v.workspaceId, v.entityId, v.runId].every(
			(x) => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\u0000-\u001f]/.test(x),
		)
	);
}
