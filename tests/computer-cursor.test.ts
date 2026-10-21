import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerCursor } from '../electron/computer-cursor';

interface CursorWindow {
	options: Record<string, unknown>;
	webContents: EventEmitter & {
		setWindowOpenHandler: ReturnType<typeof vi.fn>;
	};
	position: [number, number];
	visible: boolean;
	destroyed: boolean;
	setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
	setAlwaysOnTop: ReturnType<typeof vi.fn>;
	setPosition: ReturnType<typeof vi.fn>;
	getPosition: ReturnType<typeof vi.fn>;
	showInactive: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	loadURL: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted(() => ({
	windows: [] as CursorWindow[],
	cursorPoint: vi.fn(() => ({ x: 10, y: 20 })),
}));
vi.mock('electron', async () => {
	const { EventEmitter } = await import('node:events');
	return {
		screen: { getCursorScreenPoint: mocks.cursorPoint },
		BrowserWindow: class {
			options: Record<string, unknown>;
			webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
			position: [number, number] = [0, 0];
			visible = false;
			destroyed = false;
			setIgnoreMouseEvents = vi.fn();
			setAlwaysOnTop = vi.fn();
			setPosition = vi.fn((x: number, y: number) => {
				this.position = [x, y];
			});
			getPosition = vi.fn(() => this.position);
			isVisible = () => this.visible;
			isDestroyed = () => this.destroyed;
			showInactive = vi.fn(() => {
				this.visible = true;
			});
			hide = vi.fn(() => {
				this.visible = false;
			});
			destroy = vi.fn(() => {
				this.destroyed = true;
				this.visible = false;
			});
			loadURL = vi.fn(() => Promise.resolve());
			constructor(options: Record<string, unknown>) {
				this.options = options;
				mocks.windows.push(this);
			}
		},
	};
});

describe('Computer Use pointer overlay', () => {
	let cursor: ComputerCursor;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
		mocks.windows.length = 0;
		mocks.cursorPoint.mockClear();
		cursor = new ComputerCursor();
	});
	afterEach(() => {
		cursor.close();
		vi.useRealTimers();
	});
	const ready = () => {
		const window = mocks.windows.at(-1)!;
		window.webContents.emit('did-finish-load');
		return window;
	};
	it('uses a compact, click-through, non-focusing window that stays visible between actions', () => {
		cursor.prepare();
		const window = ready();
		expect(window.options).toMatchObject({
			width: 28,
			height: 28,
			frame: false,
			transparent: true,
			focusable: false,
			show: false,
			skipTaskbar: true,
			hasShadow: false,
			webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
		});
		expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
		expect(window.visible).toBe(false);
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		vi.advanceTimersByTime(5_000);
		expect(window.showInactive).toHaveBeenCalledOnce();
		expect(window.visible).toBe(true);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.position).toEqual([106, 217]);
	});
	it('starts at its own first target, then travels between targets without reading the user cursor', () => {
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const window = ready();
		expect(window.position).toEqual([106, 217]);
		cursor.show({ appId: 'notes', x: 210, y: 120, visible: true });
		expect(window.position).toEqual([106, 217]);
		vi.advanceTimersByTime(80);
		expect(window.position[0]).toBeGreaterThan(106);
		expect(window.position[0]).toBeLessThan(206);
		expect(window.position[1]).toBeGreaterThan(117);
		expect(window.position[1]).toBeLessThan(217);
		vi.advanceTimersByTime(160);
		expect(window.position).toEqual([206, 117]);
		expect(mocks.cursorPoint).not.toHaveBeenCalled();
		cursor.hide('notes');
		cursor.show({ appId: 'safari', x: 310, y: 420, visible: true });
		expect(window.position).toEqual([306, 417]);
		expect(mocks.cursorPoint).not.toHaveBeenCalled();
	});
	it('applies drag positions immediately and cancels an earlier animated movement', () => {
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const window = ready();
		cursor.show({ appId: 'notes', x: 210, y: 320, visible: true });
		vi.advanceTimersByTime(32);
		cursor.show({ appId: 'notes', x: 310, y: 420, visible: true, animate: false });
		expect(window.position).toEqual([306, 417]);
		cursor.show({ appId: 'notes', x: 410, y: 520, visible: true, animate: false });
		expect(window.position).toEqual([406, 517]);
		vi.advanceTimersByTime(500);
		expect(window.position).toEqual([406, 517]);
		expect(window.visible).toBe(true);
	});
	it('ignores another app stopping but hides when its own session stops', () => {
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const window = ready();
		cursor.hide('safari');
		expect(window.visible).toBe(true);
		cursor.show({ appId: 'safari', x: 0, y: 0, visible: false });
		expect(window.visible).toBe(true);
		cursor.hide('notes');
		expect(window.visible).toBe(false);
		const calls = window.setPosition.mock.calls.length;
		vi.advanceTimersByTime(5_000);
		expect(window.setPosition).toHaveBeenCalledTimes(calls);
		expect(window.visible).toBe(false);
	});
	it('does not reappear when the renderer finishes loading after a hide', () => {
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const window = mocks.windows[0];
		cursor.hide('notes');
		ready();
		vi.advanceTimersByTime(5_000);
		expect(window.showInactive).not.toHaveBeenCalled();
		expect(window.visible).toBe(false);
	});
	it('cannot be resurrected by a closed renderer loading after a replacement window', () => {
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const oldWindow = mocks.windows[0];
		cursor.close();
		cursor.show({ appId: 'safari', x: 310, y: 420, visible: true });
		oldWindow.webContents.emit('did-finish-load');
		expect(oldWindow.destroyed).toBe(true);
		expect(oldWindow.showInactive).not.toHaveBeenCalled();
		expect(mocks.windows[1].visible).toBe(false);
		const replacement = ready();
		vi.advanceTimersByTime(240);
		expect(replacement.position).toEqual([306, 417]);
		expect(replacement.visible).toBe(true);
	});
	it('stops moving a destroyed window and ignores invalid coordinates', () => {
		cursor.show({ appId: 'notes', x: Number.NaN, y: 20, visible: true });
		expect(mocks.windows).toHaveLength(0);
		cursor.show({ appId: 'notes', x: 110, y: 220, visible: true });
		const window = ready();
		vi.advanceTimersByTime(32);
		cursor.close();
		const calls = window.setPosition.mock.calls.length;
		vi.advanceTimersByTime(5_000);
		expect(window.setPosition).toHaveBeenCalledTimes(calls);
		expect(window.destroyed).toBe(true);
		expect(window.visible).toBe(false);
	});
});
