import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type {
	ComputerAction,
	ComputerApp,
	ComputerBounds,
	ComputerObservation,
	ComputerStatus,
} from '../src/computer-types';
import type { ComputerAdapter } from './tools/computer';

type CursorEvent = {
	appId: string;
	x: number;
	y: number;
	visible: boolean;
	animate?: boolean;
};
interface LinuxDependencies {
	env: NodeJS.ProcessEnv;
	executable: (file: string) => Promise<boolean>;
	run: (file: string, args: string[], signal?: AbortSignal) => Promise<Buffer>;
	processIdentity: (pid: number) => Promise<{ executable: string; started: string }>;
	now: () => number;
}
export interface LinuxComputerOptions {
	onCursor?: (event: CursorEvent) => void;
	/** Test seam. Production always uses fixed executable paths and execFile without a shell. */
	dependencies?: Partial<LinuxDependencies>;
}
interface AppWindow {
	id: string;
	pid: number;
	started: string;
	app: ComputerApp;
	bounds: ComputerBounds;
	title: string;
}
interface Frame {
	id: string;
	window: AppWindow;
	width: number;
	height: number;
	created: number;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 1440;
const FRAME_LIFETIME_MS = 300_000;
const protectedApps = new Set([
	'freelm',
	'systemsettings',
	'systemsettings5',
	'systemsettings6',
	'gnome-control-center',
	'unity-control-center',
	'xfce4-settings-manager',
	'xfce4-settings-editor',
	'lxqt-config',
	'mate-control-center',
	'cinnamon-settings',
]);
const toolNames = ['xdotool', 'wmctrl', 'import'] as const;
type ToolName = (typeof toolNames)[number];

function defaultDependencies(): LinuxDependencies {
	return {
		env: process.env,
		executable: async (file) => {
			try {
				await access(file, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
		run: (file, args, signal) =>
			new Promise((resolve, reject) => {
				execFile(
					file,
					args,
					{ encoding: 'buffer', timeout: 15_000, maxBuffer: MAX_BYTES, signal, windowsHide: true },
					(error, stdout) => {
						if (error)
							reject(
								signal?.aborted
									? (signal.reason ?? error)
									: new Error(
											`${path.basename(file)} could not complete the app operation (${error.code ?? error.signal ?? 'process error'}).`,
										),
							);
						else resolve(stdout);
					},
				);
			}),
		processIdentity: async (pid) => {
			const [executable, stat] = await Promise.all([
				realpath(`/proc/${pid}/exe`),
				readFile(`/proc/${pid}/stat`, 'utf8'),
			]);
			const started = stat
				.slice(stat.lastIndexOf(')') + 1)
				.trim()
				.split(/\s+/)[19];
			if (!executable.startsWith('/') || !/^\d+$/.test(started ?? ''))
				throw new Error('Unverified application process.');
			return { executable, started };
		},
		now: Date.now,
	};
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw signal.reason ?? new Error('Computer use was stopped.');
}

/** Read JPEG dimensions without loading a native decoder or accepting unbounded images. */
function jpegSize(data: Buffer): { width: number; height: number } {
	if (data.length < 12 || data.length > MAX_BYTES || data[0] !== 0xff || data[1] !== 0xd8)
		throw new Error('The app screenshot is not a bounded JPEG.');
	let position = 2;
	while (position + 4 < data.length) {
		if (data[position++] !== 0xff) throw new Error('Invalid app screenshot.');
		while (data[position] === 0xff) position++;
		const marker = data[position++];
		if (marker === 0xda || marker === 0xd9) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		const length = data.readUInt16BE(position);
		if (length < 2 || position + length > data.length) break;
		if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
			const height = data.readUInt16BE(position + 3);
			const width = data.readUInt16BE(position + 5);
			if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION)
				throw new Error('The app screenshot exceeds the supported dimensions.');
			return { width, height };
		}
		position += length;
	}
	throw new Error('The app screenshot has no supported JPEG dimensions.');
}

function sameWindow(a: AppWindow, b: AppWindow) {
	return (
		a.id === b.id &&
		a.pid === b.pid &&
		a.started === b.started &&
		a.app.id === b.app.id &&
		a.bounds.x === b.bounds.x &&
		a.bounds.y === b.bounds.y &&
		a.bounds.width === b.bounds.width &&
		a.bounds.height === b.bounds.height
	);
}

function keyName(value: string): string {
	const aliases: Record<string, string> = {
		enter: 'Return',
		return: 'Return',
		tab: 'Tab',
		escape: 'Escape',
		esc: 'Escape',
		backspace: 'BackSpace',
		delete: 'Delete',
		up: 'Up',
		arrowup: 'Up',
		down: 'Down',
		arrowdown: 'Down',
		left: 'Left',
		arrowleft: 'Left',
		right: 'Right',
		arrowright: 'Right',
		home: 'Home',
		end: 'End',
		pageup: 'Prior',
		pagedown: 'Next',
		space: 'space',
		' ': 'space',
		'+': 'plus',
		'-': 'minus',
		'=': 'equal',
		'/': 'slash',
		'.': 'period',
		',': 'comma',
	};
	if (typeof value !== 'string') throw new Error('Unsupported key.');
	if (aliases[value.toLowerCase()]) return aliases[value.toLowerCase()];
	if (/^[a-z0-9]$/i.test(value) || /^F([1-9]|1[0-2])$/.test(value)) return value;
	throw new Error('Unsupported key. Use a letter, digit, F1–F12, or a navigation key.');
}

/** X11 adapter. No Wayland fallback, shell execution, desktop capture, or arbitrary executable launch. */
export class LinuxComputerAdapter implements ComputerAdapter {
	private readonly dependencies: LinuxDependencies;
	private readonly lifecycle = new AbortController();
	private tools?: Record<ToolName, string>;
	private readonly knownApps = new Set<string>();
	private readonly selectedWindows = new Map<string, string>();
	private readonly frames = new Map<string, Frame>();
	private busy = false;
	constructor(options: LinuxComputerOptions = {}) {
		this.dependencies = { ...defaultDependencies(), ...options.dependencies };
	}
	private signal(signal?: AbortSignal) {
		return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
	}
	async status(signal?: AbortSignal): Promise<ComputerStatus> {
		throwIfAborted(this.signal(signal));
		const unavailable = (message: string): ComputerStatus => ({
			available: false,
			platform: 'linux',
			accessibility: false,
			screenRecording: false,
			message,
		});
		if (
			this.dependencies.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
			this.dependencies.env.WAYLAND_DISPLAY
		)
			return unavailable(
				'Computer Use currently supports Linux X11 sessions. Wayland capture and input require a portal adapter, which is not included yet.',
			);
		if (!this.dependencies.env.DISPLAY)
			return unavailable('Computer Use requires a running X11 desktop session.');
		const found = {} as Record<ToolName, string>;
		for (const name of toolNames) {
			for (const prefix of ['/usr/bin', '/bin']) {
				const file = `${prefix}/${name}`;
				if (await this.dependencies.executable(file)) {
					found[name] = file;
					break;
				}
			}
		}
		const missing = toolNames.filter((name) => !found[name]);
		if (missing.length)
			return unavailable(
				`Install the Linux X11 tools xdotool, wmctrl, and ImageMagick (missing: ${missing.join(', ')}).`,
			);
		this.tools = found;
		return {
			available: true,
			platform: 'linux',
			accessibility: true,
			screenRecording: true,
			message:
				'X11: background window capture and window-targeted keyboard input are available. Independent pointer input and accessibility elements are not supported by this adapter. Some apps ignore synthetic keyboard input.',
		};
	}
	private async ready(signal?: AbortSignal) {
		throwIfAborted(this.signal(signal));
		if (!this.tools) {
			const status = await this.status(signal);
			if (!status.available) throw new Error(status.message);
		}
	}
	private async run(tool: ToolName, args: string[], signal?: AbortSignal) {
		const combined = this.signal(signal);
		throwIfAborted(combined);
		const result = await this.dependencies.run(this.tools![tool], args, combined);
		throwIfAborted(combined);
		if (result.length > MAX_BYTES) throw new Error('The app operation returned too much data.');
		return result;
	}
	private async windows(signal?: AbortSignal): Promise<AppWindow[]> {
		await this.ready(signal);
		const data = (await this.run('wmctrl', ['-lpGx'], signal)).toString('utf8');
		const windows: AppWindow[] = [];
		const processes = new Map<number, { executable: string; started: string } | null>();
		for (const line of data.split('\n').slice(0, 512)) {
			throwIfAborted(this.signal(signal));
			// wmctrl columns: id desktop pid x y width height WM_CLASS host title.
			const match =
				/^(0x[0-9a-f]+)\s+-?\d+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s*(.*)$/i.exec(
					line,
				);
			if (!match) continue;
			const [, id, pidText, x, y, width, height, windowClass, title] = match;
			const pid = Number(pidText);
			const bounds = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
			if (
				!Number.isSafeInteger(pid) ||
				pid < 1 ||
				pid === process.pid ||
				bounds.width < 1 ||
				bounds.height < 1 ||
				bounds.width > 16_384 ||
				bounds.height > 16_384 ||
				!Number.isSafeInteger(bounds.x) ||
				!Number.isSafeInteger(bounds.y)
			)
				continue;
			if (!processes.has(pid))
				processes.set(pid, await this.dependencies.processIdentity(pid).catch(() => null));
			const identity = processes.get(pid);
			if (!identity || !identity.executable.startsWith('/') || !/^\d+$/.test(identity.started))
				continue;
			const appId = `linux:${createHash('sha256').update(`${identity.executable}\0${windowClass}`).digest('hex')}`;
			if (
				[path.basename(identity.executable), ...windowClass.split('.')].some((name) =>
					protectedApps.has(name.toLowerCase()),
				)
			)
				continue;
			const label = windowClass.split('.').at(-1) || path.basename(identity.executable);
			windows.push({
				id: String(BigInt(id)),
				pid,
				started: identity.started,
				app: { id: appId, name: label.slice(0, 128) },
				bounds,
				title: title.slice(0, 500),
			});
		}
		return windows;
	}
	async apps(query: string, signal?: AbortSignal): Promise<ComputerApp[]> {
		const found = new Map<string, ComputerApp>();
		for (const window of await this.windows(signal)) {
			this.knownApps.add(window.app.id);
			if (!query || window.app.name.toLowerCase().includes(query.slice(0, 200).toLowerCase()))
				found.set(window.app.id, window.app);
		}
		return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
	}
	private async selected(appId: string, signal?: AbortSignal) {
		if (!this.knownApps.has(appId))
			throw new Error('Select an app returned by Computer Use discovery first.');
		const windows = (await this.windows(signal)).filter((window) => window.app.id === appId);
		const selected =
			windows.find((window) => window.id === this.selectedWindows.get(appId)) ?? windows[0];
		if (!selected)
			throw new Error(
				'This app no longer has an available window. Open it, then discover apps again.',
			);
		return selected;
	}
	async open(appId: string, signal?: AbortSignal): Promise<void> {
		// Selecting a target must not activate it or change the user's input focus.
		const window = await this.selected(appId, signal);
		this.selectedWindows.set(appId, window.id);
		this.frames.delete(appId);
	}
	async snapshot(appId: string, signal?: AbortSignal): Promise<ComputerObservation> {
		try {
			const window = await this.selected(appId, signal);
			const image = await this.run(
				'import',
				[
					'-limit',
					'memory',
					'64MiB',
					'-limit',
					'map',
					'128MiB',
					'-limit',
					'disk',
					'0',
					'-window',
					window.id,
					'-silent',
					'-resize',
					'1440x1440>',
					'-strip',
					'-quality',
					'80',
					'jpeg:-',
				],
				signal,
			);
			const size = jpegSize(image);
			const after = await this.selected(appId, signal);
			if (!sameWindow(window, after))
				throw new Error('The app window changed while capturing. Take another snapshot.');
			const frame: Frame = { id: randomUUID(), window, ...size, created: this.dependencies.now() };
			this.frames.set(appId, frame);
			this.selectedWindows.set(appId, window.id);
			return {
				app: window.app,
				frameId: frame.id,
				window: { id: window.id, title: window.title, bounds: window.bounds },
				image: { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`, ...size },
				elements: [],
				notices: [
					'X11 adapter: only window-targeted type and key actions are available. Pointer actions (click, double_click, scroll, drag) are unavailable because xdotool cannot send them at independent coordinates without moving the user’s pointer. Do not retry these actions or use a global-input fallback. Some apps ignore synthetic keyboard input; check the next observation for the result.',
				],
			};
		} catch (error) {
			// Failed observations must not leave older usable frames behind.
			this.frames.delete(appId);
			throw error;
		}
	}
	async act(
		appId: string,
		frameId: string,
		action: ComputerAction,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.busy) throw new Error('Another computer action is still running.');
		this.busy = true;
		try {
			const frame = this.frames.get(appId);
			if (
				!frame ||
				frame.id !== frameId ||
				this.dependencies.now() - frame.created > FRAME_LIFETIME_MS
			)
				throw new Error('This computer snapshot is stale. Take a fresh snapshot before acting.');
			const window = await this.selected(appId, signal);
			if (!sameWindow(frame.window, window))
				throw new Error(
					'The app window moved, resized, or changed process. Take a fresh snapshot.',
				);
			let key: string | undefined;
			if (action.type === 'press' || action.type === 'select' || action.type === 'set_value')
				throw new Error(
					'Linux X11 currently supports background screenshots and window-targeted typing and keys; accessibility element actions are unavailable.',
				);
			if (
				action.type === 'type' &&
				(typeof action.text !== 'string' ||
					!action.text.length ||
					action.text.length > 16_384 ||
					action.text.includes('\0'))
			)
				throw new Error('Type between 1 and 16,384 characters without null bytes.');
			if (action.type === 'key') {
				key = keyName(action.key);
				const modifiers = action.modifiers ?? [];
				if (
					!Array.isArray(modifiers) ||
					modifiers.length > 4 ||
					modifiers.some((value) => !['cmd', 'ctrl', 'alt', 'shift'].includes(value))
				)
					throw new Error('Unsupported key modifier.');
				key = [...new Set(modifiers.map((value) => (value === 'cmd' ? 'super' : value))), key].join(
					'+',
				);
			}
			if (['click', 'double_click', 'scroll', 'drag'].includes(action.type)) {
				// xdotool mousemove --window still warps the global pointer, and
				// click --window derives its coordinates from that same pointer.
				// Reject before consuming the frame or sending any input.
				throw new Error(
					'Independent pointer input is unavailable on Linux X11 with the current adapter. No input was sent and the user’s pointer was not moved. Observe again, then use window-targeted keyboard input or a dedicated browser integration.',
				);
			}
			if (action.type !== 'type' && action.type !== 'key')
				throw new Error('Unsupported computer action.');
			// Consume each observation once input starts. A rejected capability check
			// above is safe to retry with a supported action on the same observation.
			this.frames.delete(appId);
			if (action.type === 'type')
				await this.run(
					'xdotool',
					['type', '--window', window.id, '--delay', '0', '--', action.text],
					signal,
				);
			else await this.run('xdotool', ['key', '--window', window.id, key!], signal);
		} finally {
			this.busy = false;
		}
	}

	close(): void {
		this.lifecycle.abort(new Error('Computer use was stopped.'));
		this.frames.clear();
		this.knownApps.clear();
		this.selectedWindows.clear();
	}
}

export function createLinuxComputerAdapter(options: LinuxComputerOptions = {}): ComputerAdapter {
	return new LinuxComputerAdapter(options);
}
