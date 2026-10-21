/** Host-verified application identities; mentions are references, never grants. */
export interface ComputerApp {
	id: string;
	name: string;
	icon?: string;
}
export interface ComputerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface ComputerElement {
	id: string;
	role: string;
	label?: string;
	value?: string;
	bounds?: ComputerBounds;
	actions?: string[];
}
export interface ComputerObservation {
	app: ComputerApp;
	frameId: string;
	window: { id: string; title: string; bounds: ComputerBounds };
	image: { dataUrl: string; width: number; height: number };
	elements: ComputerElement[];
	notices?: string[];
}
export type ComputerAction =
	| { type: 'click' | 'double_click'; x: number; y: number }
	| { type: 'drag'; x: number; y: number; toX: number; toY: number }
	| { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
	| { type: 'type'; text: string }
	| { type: 'key'; key: string; modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[] }
	| { type: 'press'; elementId: string }
	| { type: 'select'; elementId: string }
	| { type: 'set_value'; elementId: string; text: string };
export interface ComputerStatus {
	available: boolean;
	platform: string;
	accessibility: boolean;
	screenRecording: boolean;
	/** Omitted when the desktop adapter cannot determine this state. */
	screenLocked?: boolean;
	/** Whether this user's graphical session is currently active; unknown is omitted. */
	sessionActive?: boolean;
	/** Whether at least one connected display is awake; unknown is omitted. */
	displaysAwake?: boolean;
	message?: string;
}
export interface ComputerSessionPreview {
	sessionId: string;
	runId: string;
	threadId: string;
	app: ComputerApp;
	status: 'active' | 'stopped';
	image?: ComputerObservation['image'];
	windowTitle?: string;
	updatedAt: number;
}
export interface ComputerPermission {
	app: ComputerApp;
	/** Access lasts for this run only, and is revoked on Stop or completion. */
	scope: 'run';
	/** A paused tool needs operating-system setup before it can continue. */
	setup?: ComputerStatus;
}
