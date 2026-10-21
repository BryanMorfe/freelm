import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBrowserService, codeBrowserBounds, codeBrowserUrl } from '../electron/code-browser';

const mocks = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[] }));
vi.mock('electron', async () => {
	const { EventEmitter } = await import('node:events');
	return {
		Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
		session: {
			fromPartition: vi.fn((partition, options) => {
				const session = Object.assign(new EventEmitter(), {
					partition,
					options,
					setPermissionCheckHandler: vi.fn(),
					setPermissionRequestHandler: vi.fn(),
					setDevicePermissionHandler: vi.fn(),
					setDisplayMediaRequestHandler: vi.fn(),
					webRequest: { onBeforeRequest: vi.fn() },
					clearStorageData: vi.fn(async () => {}),
				});
				mocks.sessions.push(session);
				return session;
			}),
		},
		WebContentsView: class {
			options: unknown;
			visible = false;
			url = '';
			destroyed = false;
			setVisible = vi.fn((visible) => {
				this.visible = visible;
			});
			setBounds = vi.fn();
			webContents = Object.assign(new EventEmitter(), {
				isDestroyed: () => this.destroyed,
				getURL: () => this.url,
				getTitle: () => 'Example',
				isLoading: () => false,
				isLoadingMainFrame: vi.fn(() => false),
				loadURL: vi.fn(async (url) => {
					this.url = url;
				}),
				reload: vi.fn(),
				openDevTools: vi.fn(),
				inspectElement: vi.fn(),
				setWindowOpenHandler: vi.fn(),
				executeJavaScriptInIsolatedWorld: vi.fn(async () => null),
				navigationHistory: {
					canGoBack: () => true,
					canGoForward: () => true,
					goBack: vi.fn(),
					goForward: vi.fn(),
				},
				close: vi.fn(() => {
					this.destroyed = true;
				}),
				capturePage: vi.fn(async () => ({
					isEmpty: () => false,
					getSize: () => ({ width: 640, height: 400 }),
					toPNG: () => Buffer.from('png'),
				})),
			});
			constructor(options: unknown) {
				this.options = options;
				mocks.views.push(this);
			}
		},
	};
});

function fixture() {
	const window = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		getContentBounds: () => ({ width: 1200, height: 800 }),
		webContents: Object.assign(new EventEmitter(), { getZoomFactor: () => 1.25 }),
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
	});
	const callbacks = { onState: vi.fn(), onElement: vi.fn() };
	return {
		window,
		callbacks,
		service: new CodeBrowserService(window as unknown as BrowserWindow, callbacks),
	};
}

beforeEach(() => {
	mocks.views.length = 0;
	mocks.sessions.length = 0;
});

describe('Code browser navigation and layout validation', () => {
	it.each([
		['localhost:3000/path', 'http://localhost:3000/path'],
		['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
		['[::1]:5173', 'http://[::1]:5173/'],
		['example.com', 'https://example.com/'],
		['example.com:8443/test', 'https://example.com:8443/test'],
		['http://192.168.0.221:8080', 'http://192.168.0.221:8080/'],
	])('normalizes %s', (input, expected) => expect(codeBrowserUrl(input)).toBe(expected));
	it.each([
		'file:///etc/passwd',
		'freelm://settings',
		'javascript:alert(1)',
		'data:text/html,hi',
		'https://user:password@example.com',
		'',
		'http://',
	])('rejects unsafe destination %s', (url) => {
		expect(() => codeBrowserUrl(url)).toThrow();
	});
	it('clips supplied bounds to the actual app content and rejects non-finite coordinates', () => {
		expect(codeBrowserBounds({ x: -5, y: 100, width: 2000, height: 1000 }, 1200, 800)).toEqual({
			x: 0,
			y: 100,
			width: 1200,
			height: 700,
		});
		expect(() => codeBrowserBounds({ x: NaN, y: 1, width: 10, height: 10 }, 1200, 800)).toThrow();
	});
});

describe('Code browser isolation and lifecycle', () => {
	it('uses memory-only per-tab partitions without privileged preload or Node', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread', url: 'localhost:3000' });
		await service.handle({
			action: 'open',
			tabId: 'two',
			scope: 'thread',
			url: 'https://example.com',
		});
		expect(mocks.sessions[0].partition).not.toMatch(/^persist:/);
		expect(mocks.sessions[0].partition).not.toBe(mocks.sessions[1].partition);
		expect(mocks.views[0].options).toMatchObject({
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				webviewTag: false,
				allowRunningInsecureContent: false,
			},
		});
		expect(mocks.views[0].options.webPreferences.preload).toBeUndefined();
		await expect(service.handle({ action: 'open', tabId: 'one', scope: 'other' })).rejects.toThrow(
			'different task',
		);
		service.dispose();
	});
	it('denies page permissions, executable protocols and downloads', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread' });
		const ses = mocks.sessions[0];
		expect(ses.setPermissionCheckHandler.mock.calls[0][0](null, 'media')).toBe(false);
		const permission = vi.fn();
		ses.setPermissionRequestHandler.mock.calls[0][0](null, 'clipboard-read', permission);
		expect(permission).toHaveBeenCalledWith(false);
		for (const url of [
			'file:///etc/passwd',
			'freelm://api',
			'javascript:alert(1)',
			'chrome://settings',
			'https://u:p@example.com',
		]) {
			const callback = vi.fn();
			ses.webRequest.onBeforeRequest.mock.calls[0][0]({ url, resourceType: 'mainFrame' }, callback);
			expect(callback).toHaveBeenCalledWith({ cancel: true });
		}
		for (const [url, resourceType] of [
			['http://localhost:3000', 'mainFrame'],
			['ws://localhost:3000', 'webSocket'],
			['blob:http://localhost:3000/id', 'image'],
		]) {
			const callback = vi.fn();
			ses.webRequest.onBeforeRequest.mock.calls[0][0]({ url, resourceType }, callback);
			expect(callback).toHaveBeenCalledWith({ cancel: false });
		}
		const download = { preventDefault: vi.fn() };
		ses.emit('will-download', download);
		expect(download.preventDefault).toHaveBeenCalledOnce();
		service.dispose();
	});
	it('keeps safe new-window links in the same browser and never launches protocols', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread' });
		const contents = mocks.views[0].webContents;
		const handler = contents.setWindowOpenHandler.mock.calls[0][0];
		expect(handler({ url: 'mailto:user@example.com' })).toEqual({ action: 'deny' });
		expect(contents.loadURL).not.toHaveBeenCalled();
		expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
		expect(contents.loadURL).toHaveBeenCalledWith('https://example.com');
		service.dispose();
	});
	it('shows only one tab, respects app zoom, and releases tabs on app renderer navigation', async () => {
		const { service, window } = fixture();
		for (const tabId of ['one', 'two'])
			await service.handle({ action: 'open', tabId, scope: 'thread' });
		const bounds = { x: 400, y: 80, width: 500, height: 500 };
		await service.handle({ action: 'show', tabId: 'one', bounds });
		expect(mocks.views[0].setBounds).toHaveBeenLastCalledWith({
			x: 500,
			y: 100,
			width: 625,
			height: 625,
		});
		await service.handle({ action: 'show', tabId: 'two', bounds });
		expect(mocks.views[0].visible).toBe(false);
		expect(mocks.views[1].visible).toBe(true);
		window.webContents.emit('did-start-navigation', {}, 'http://localhost', false, true);
		expect(mocks.views[0].destroyed).toBe(true);
		expect(mocks.views[1].destroyed).toBe(true);
		await expect(service.handle({ action: 'state', tabId: 'two' })).rejects.toThrow('closed');
		// The service remains usable after the app renderer has reloaded.
		await service.handle({ action: 'open', tabId: 'after-reload', scope: 'thread' });
		expect(mocks.views[2].destroyed).toBe(false);
		window.webContents.emit('render-process-gone');
		expect(mocks.views[2].destroyed).toBe(true);
		service.dispose();
	});
	it('does not capture a page while its main frame is loading', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread', url: 'localhost:3000' });
		mocks.views[0].webContents.isLoadingMainFrame.mockReturnValue(true);
		await expect(service.handle({ action: 'capture', tabId: 'one' })).rejects.toThrow(
			'finish loading',
		);
		expect(mocks.views[0].webContents.capturePage).not.toHaveBeenCalled();
		service.dispose();
	});
	it('rejects screenshot pixels if navigation changed the page during capture', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread', url: 'localhost:3000' });
		const view = mocks.views[0];
		const image = await view.webContents.capturePage();
		view.webContents.capturePage.mockImplementationOnce(async () => {
			view.url = 'https://example.com/next';
			return image;
		});
		await expect(service.handle({ action: 'capture', tabId: 'one' })).rejects.toThrow('navigated');
		service.dispose();
	});
	it('captures actual pixels and keeps annotation scripts inside the isolated world', async () => {
		const { service } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread', url: 'localhost:3000' });
		const result = await service.handle({ action: 'capture', tabId: 'one' });
		expect(result.screenshot).toMatchObject({
			dataUrl: 'data:image/png;base64,cG5n',
			width: 640,
			height: 400,
			url: 'http://localhost:3000/',
		});
		await service.handle({
			action: 'annotations',
			tabId: 'one',
			annotations: [
				{
					id: 'a',
					comment: 'hello',
					element: {
						tag: 'button',
						text: 'Send',
						selector: '#send',
						url: 'http://localhost:3000/',
						rect: { x: 10, y: 10, width: 50, height: 20 },
					},
				},
			],
			visible: true,
		});
		const [world, scripts] =
			mocks.views[0].webContents.executeJavaScriptInIsolatedWorld.mock.calls.at(-1);
		expect(world).toBeGreaterThan(999);
		expect(scripts[0].code).toContain('globalThis.__freelmBrowserOverlay.markers(');
		expect(scripts[0].code).not.toContain('comment');
		service.dispose();
	});
	it('ignores a late selection after hiding a tab and closes without beforeunload veto', async () => {
		const { service, callbacks, window } = fixture();
		await service.handle({ action: 'open', tabId: 'one', scope: 'thread', url: 'localhost:3000' });
		await service.handle({
			action: 'show',
			tabId: 'one',
			bounds: { x: 0, y: 0, width: 500, height: 500 },
		});
		let resolve!: (value: unknown) => void;
		mocks.views[0].webContents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await service.handle({ action: 'inspect', tabId: 'one' });
		await service.handle({ action: 'hide', tabId: 'one' });
		resolve({
			tag: 'button',
			text: 'ignored',
			selector: '#button',
			url: 'http://localhost:3000/',
			rect: { x: 0, y: 0, width: 1, height: 1 },
		});
		await Promise.resolve();
		expect(callbacks.onElement).not.toHaveBeenCalled();
		await service.handle({ action: 'close', tabId: 'one' });
		expect(mocks.views[0].webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
		expect(window.contentView.removeChildView).toHaveBeenCalledWith(mocks.views[0]);
		expect(mocks.sessions[0].clearStorageData).toHaveBeenCalledOnce();
	});
});
