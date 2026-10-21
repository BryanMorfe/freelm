import { BrowserWindow } from 'electron';

export const COMPUTER_CURSOR_SIZE = 28;
export const COMPUTER_CURSOR_TRAVEL_MS = 200;
const hotspot = { x: 4, y: 3 };
// Rounded corners soften the activity marker while preserving its arrow shape
// and the small, curved indent where a traditional pointer's tail would be.
const cursorPath =
	'M5.740 8.801 A2.4 2.4 0 0 1 9.242 6.035 L18.116 11.173 A2.2 2.2 0 0 1 17.491 15.224 L14.864 15.808 A2 2 0 0 0 13.561 16.768 L12.544 18.548 A2.2 2.2 0 0 1 8.527 18.089 Z';

/** A persistent, click-through marker. It never sends input or takes focus. */
export class ComputerCursor {
	private window?: BrowserWindow;
	private ready = false;
	private movement?: ReturnType<typeof setInterval>;
	private position?: { x: number; y: number };
	private appId?: string;
	private animate = true;

	/** Warm the renderer when a session opens, before its first input action. */
	prepare() {
		if (this.window && !this.window.isDestroyed()) return;
		this.ready = false;
		const window = new BrowserWindow({
			width: COMPUTER_CURSOR_SIZE,
			height: COMPUTER_CURSOR_SIZE,
			frame: false,
			transparent: true,
			focusable: false,
			show: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
		});
		this.window = window;
		window.setIgnoreMouseEvents(true);
		window.setAlwaysOnTop(true, 'floating');
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		window.webContents.on('will-navigate', (event) => event.preventDefault());
		window.webContents.once('did-finish-load', () => {
			if (this.window !== window || window.isDestroyed()) return;
			this.ready = true;
			this.place();
		});
		void window
			.loadURL(
				'data:text/html;charset=utf-8,' +
					encodeURIComponent(
						`<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;overflow:hidden;background:transparent}
svg{display:block;filter:drop-shadow(0 1px 1.5px #0009)}
.agent-pointer{transform-box:fill-box;transform-origin:center;animation:cursor-rock 500ms ease-in-out infinite alternate}
/* Two half-second legs make one complete outward-and-return cycle. */
@keyframes cursor-rock{from{transform:rotate(0deg)}to{transform:rotate(10deg)}}
@media(prefers-reduced-motion:reduce){.agent-pointer{animation:none}}
</style>
<svg width="28" height="28" viewBox="0 0 28 28" shape-rendering="geometricPrecision"><g class="agent-pointer"><path d="${cursorPath}" fill="#80baff" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></g></svg>`,
					),
			)
			.catch(() => {
				if (this.window === window) this.close();
			});
	}

	show(event: { appId: string; x: number; y: number; visible: boolean; animate?: boolean }) {
		if (!event.visible) {
			this.hide(event.appId);
			return;
		}
		if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
		if (this.appId && this.appId !== event.appId) this.hide();
		this.appId = event.appId;
		this.position = { x: Math.round(event.x) - hotspot.x, y: Math.round(event.y) - hotspot.y };
		this.animate = event.animate !== false;
		this.prepare();
		this.place();
	}

	private place() {
		const window = this.window;
		if (!this.ready || !this.position || !window || window.isDestroyed()) return;
		clearInterval(this.movement);
		const target = this.position;
		if (!window.isVisible()) {
			// The agent has its own position; never borrow or follow the user's cursor.
			window.setPosition(target.x, target.y, false);
			window.showInactive();
		}
		const [x, y] = window.getPosition();
		if (!this.animate || (x === target.x && y === target.y)) {
			window.setPosition(target.x, target.y, false);
			return;
		}
		const started = performance.now();
		this.movement = setInterval(() => {
			if (this.window !== window || window.isDestroyed() || this.position !== target) {
				clearInterval(this.movement);
				return;
			}
			const progress = Math.min(1, (performance.now() - started) / COMPUTER_CURSOR_TRAVEL_MS);
			const eased = 1 - (1 - progress) ** 3;
			window.setPosition(
				Math.round(x + (target.x - x) * eased),
				Math.round(y + (target.y - y) * eased),
				false,
			);
			if (progress === 1) clearInterval(this.movement);
		}, 16);
	}

	/** A different app/session stopping must not remove the active app's marker. */
	hide(appId?: string) {
		if (appId && this.appId !== appId) return;
		clearInterval(this.movement);
		this.movement = undefined;
		this.position = undefined;
		this.appId = undefined;
		if (this.window && !this.window.isDestroyed()) this.window.hide();
	}
	close() {
		this.hide();
		this.window?.destroy();
		this.window = undefined;
		this.ready = false;
	}
}
