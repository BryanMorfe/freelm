import { randomUUID } from 'node:crypto';
import { Menu, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import type {
	CodeBrowserAnnotation,
	CodeBrowserBounds,
	CodeBrowserElement,
	CodeBrowserRequest,
	CodeBrowserResult,
	CodeBrowserSelection,
	CodeBrowserState,
} from '../src/code-browser-types';

const WORLD = 1007;
const MAX_TABS = 12;
const MAX_ANNOTATIONS = 40;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** URLs are navigation destinations, never shell commands or privileged app routes. */
export function codeBrowserUrl(input: unknown): string {
	if (typeof input !== 'string' || !input.trim() || input.length > 8_192)
		throw new Error('Enter an HTTP or HTTPS address.');
	const value = input.trim();
	const bareHostWithPort = /^(?:[a-z\d.-]+|\[[a-f\d:]+\]):\d+(?:[/?#]|$)/i.test(value);
	const withProtocol =
		/^[a-z][a-z\d+.-]*:/i.test(value) && !bareHostWithPort
			? value
			: `${/^(localhost|127\.0\.0\.1|\[::1\])(?:[:/?#]|$)/i.test(value) ? 'http' : 'https'}://${value}`;
	let url: URL;
	try {
		url = new URL(withProtocol);
	} catch {
		throw new Error('Enter a valid HTTP or HTTPS address.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
		throw new Error('The browser supports HTTP and HTTPS addresses without embedded credentials.');
	return url.href;
}

function httpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
	} catch {
		return false;
	}
}

export function codeBrowserBounds(
	input: unknown,
	width: number,
	height: number,
): CodeBrowserBounds {
	if (!input || typeof input !== 'object') throw new Error('Browser bounds are required.');
	const bounds = input as CodeBrowserBounds;
	if (
		!['x', 'y', 'width', 'height'].every((key) =>
			Number.isFinite(bounds[key as keyof typeof bounds]),
		)
	)
		throw new Error('Browser bounds must be finite numbers.');
	const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
	const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
	return {
		x,
		y,
		width: Math.max(0, Math.min(width - x, Math.round(bounds.width))),
		height: Math.max(0, Math.min(height - y, Math.round(bounds.height))),
	};
}

function identifier(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))
		throw new Error(`Invalid browser ${name}.`);
	return value;
}

function elementData(value: unknown): CodeBrowserElement {
	if (!value || typeof value !== 'object') throw new Error('Invalid browser selection.');
	const data = value as CodeBrowserElement;
	if (
		typeof data.tag !== 'string' ||
		typeof data.text !== 'string' ||
		typeof data.selector !== 'string' ||
		typeof data.url !== 'string' ||
		!httpUrl(data.url) ||
		!data.rect ||
		!['x', 'y', 'width', 'height'].every((key) =>
			Number.isFinite(data.rect[key as keyof CodeBrowserBounds]),
		)
	)
		throw new Error('Invalid browser selection.');
	return {
		tag: data.tag.slice(0, 80),
		text: data.text.slice(0, 2_000),
		selector: data.selector.slice(0, 2_000),
		url: data.url.slice(0, 8_192),
		rect: {
			x: data.rect.x,
			y: data.rect.y,
			width: Math.max(0, data.rect.width),
			height: Math.max(0, data.rect.height),
		},
	};
}

interface BrowserTab {
	id: string;
	scope: string;
	view: WebContentsView;
	session: Session;
	url: string;
	error?: string;
	visible: boolean;
	inspecting: boolean;
	inspection: number;
	annotations: CodeBrowserAnnotation[];
	markersVisible: boolean;
}

interface BrowserCallbacks {
	onState: (state: CodeBrowserState) => void;
	onElement: (selection: CodeBrowserSelection) => void;
}

/**
 * Each tab has a sandboxed renderer and a separate memory-only session. It receives
 * no preload, Node APIs, main-app IPC, filesystem protocol, or agent tools. Main
 * must validate the calling IPC sender before passing a request to this service.
 */
export class CodeBrowserService {
	private readonly tabs = new Map<string, BrowserTab>();
	private disposed = false;

	constructor(
		private readonly window: BrowserWindow,
		private readonly callbacks: BrowserCallbacks,
	) {
		window.once('closed', () => this.dispose());
		window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
			if (mainFrame && !inPlace) this.reset();
		});
		window.webContents.on('render-process-gone', () => this.reset());
	}

	async handle(input: unknown): Promise<CodeBrowserResult> {
		if (this.disposed || this.window.isDestroyed())
			throw new Error('The browser window is closed.');
		if (!input || typeof input !== 'object') throw new Error('Invalid browser request.');
		const request = input as CodeBrowserRequest;
		if (request.action === 'hide') {
			this.hide(request.tabId === undefined ? undefined : identifier(request.tabId, 'tab'));
			return {};
		}
		const id = identifier(request.tabId, 'tab');
		if (request.action === 'open') {
			const scope = identifier(request.scope, 'scope');
			const url = request.url ? codeBrowserUrl(request.url) : '';
			const existing = this.tabs.get(id);
			if (existing && existing.scope !== scope)
				throw new Error('This browser tab belongs to a different task.');
			const tab = existing ?? this.create(id, scope);
			if (url && url !== tab.url) this.navigate(tab, url);
			return { state: this.state(tab) };
		}
		const tab = this.tabs.get(id);
		if (!tab || tab.view.webContents.isDestroyed()) throw new Error('This browser tab is closed.');
		const contents = tab.view.webContents;
		switch (request.action) {
			case 'show': {
				const { width, height } = this.window.getContentBounds();
				const zoom = this.window.webContents.getZoomFactor();
				// Renderer DOM rects are CSS pixels; Electron child views use window DIPs.
				const css = codeBrowserBounds(request.bounds, width / zoom, height / zoom);
				const bounds = codeBrowserBounds(
					{
						x: css.x * zoom,
						y: css.y * zoom,
						width: css.width * zoom,
						height: css.height * zoom,
					},
					width,
					height,
				);
				this.hide(id, true);
				tab.view.setBounds(bounds);
				tab.visible = bounds.width > 0 && bounds.height > 0;
				tab.view.setVisible(tab.visible);
				break;
			}
			case 'navigate':
				this.navigate(tab, codeBrowserUrl(request.url));
				break;
			case 'back':
				if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
				break;
			case 'forward':
				if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
				break;
			case 'reload':
				tab.error = undefined;
				contents.reload();
				break;
			case 'close':
				this.close(tab);
				return {};
			case 'state':
				break;
			case 'inspect':
				if (request.enabled === false) await this.stopInspection(tab);
				else this.inspect(tab);
				break;
			case 'annotations':
				if (!Array.isArray(request.annotations) || request.annotations.length > MAX_ANNOTATIONS)
					throw new Error(`A browser tab supports up to ${MAX_ANNOTATIONS} annotations.`);
				tab.annotations = request.annotations.map((annotation) => {
					if (typeof annotation?.comment !== 'string' || annotation.comment.length > 8_000)
						throw new Error('Invalid annotation comment.');
					return {
						id: identifier(annotation.id, 'annotation'),
						element: elementData(annotation.element),
						comment: annotation.comment,
					};
				});
				tab.markersVisible = request.visible === true;
				await this.markers(tab);
				break;
			case 'capture': {
				const capturedUrl = contents.getURL();
				if (!httpUrl(capturedUrl)) throw new Error('Open a page before taking a screenshot.');
				if (contents.isLoadingMainFrame())
					throw new Error('Wait for the page to finish loading before taking a screenshot.');
				// DOM annotation updates resolve before Chromium composites their pixels.
				// Wait through a paint so the attached image includes the current markers.
				await contents.executeJavaScriptInIsolatedWorld(WORLD, [
					{
						code: 'new Promise(resolve => { const timer = setTimeout(resolve, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });',
					},
				]);
				let image = await contents.capturePage();
				if (
					contents.isDestroyed() ||
					contents.isLoadingMainFrame() ||
					contents.getURL() !== capturedUrl
				)
					throw new Error(
						'The browser navigated while taking the screenshot. Try again on the current page.',
					);
				if (image.isEmpty()) throw new Error('The browser has not rendered a screenshot yet.');
				const original = image.getSize();
				if (Math.max(original.width, original.height) > 2_048)
					image = image.resize({
						width: Math.max(
							1,
							Math.round(original.width * (2_048 / Math.max(original.width, original.height))),
						),
						height: Math.max(
							1,
							Math.round(original.height * (2_048 / Math.max(original.width, original.height))),
						),
						quality: 'best',
					});
				const png = image.toPNG();
				if (png.length > MAX_SCREENSHOT_BYTES)
					throw new Error('This screenshot exceeds the 8 MiB limit.');
				return {
					state: this.state(tab),
					screenshot: {
						dataUrl: `data:image/png;base64,${png.toString('base64')}`,
						...image.getSize(),
						url: capturedUrl,
						title: contents.getTitle().slice(0, 500),
					},
				};
			}
			case 'devtools':
				contents.openDevTools({ mode: 'detach' });
				break;
			default:
				throw new Error('Unsupported browser action.');
		}
		return { state: this.emit(tab) };
	}

	private create(id: string, scope: string): BrowserTab {
		if (this.tabs.size >= MAX_TABS) throw new Error('Close a browser tab before opening another.');
		const isolated = session.fromPartition(`freelm-code-browser-${randomUUID()}`, { cache: false });
		isolated.setPermissionCheckHandler(() => false);
		isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		isolated.setDevicePermissionHandler(() => false);
		isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
		// Block app/file/extension/executable protocols for every resource, including
		// redirects. HTTP(S), web sockets and ordinary in-page blobs remain available.
		isolated.webRequest.onBeforeRequest((details, callback) => {
			let allowed = false;
			try {
				const url = new URL(details.url);
				allowed =
					details.resourceType === 'mainFrame'
						? httpUrl(details.url)
						: ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:'].includes(url.protocol);
			} catch {
				/* Invalid URLs are rejected. */
			}
			callback({ cancel: !allowed });
		});
		const view = new WebContentsView({
			webPreferences: {
				session: isolated,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInWorker: false,
				nodeIntegrationInSubFrames: false,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				safeDialogs: true,
				navigateOnDragDrop: false,
			},
		});
		const tab: BrowserTab = {
			id,
			scope,
			view,
			session: isolated,
			url: '',
			visible: false,
			inspecting: false,
			inspection: 0,
			annotations: [],
			markersVisible: true,
		};
		this.tabs.set(id, tab);
		view.setVisible(false);
		this.window.contentView.addChildView(view);
		const contents = view.webContents;
		isolated.on('will-download', (event) => {
			event.preventDefault();
			tab.error = 'Downloads are not available in this preview browser.';
			this.emit(tab);
		});
		contents.setWindowOpenHandler(({ url }) => {
			// Links with target=_blank stay in the already-authorized browser surface.
			if (httpUrl(url)) this.navigate(tab, url);
			return { action: 'deny' };
		});
		contents.on('will-navigate', (event, url) => {
			if (!httpUrl(url)) event.preventDefault();
		});
		contents.on('will-redirect', (event, url) => {
			if (!httpUrl(url)) event.preventDefault();
		});
		contents.on('will-frame-navigate', (event) => {
			const url = event.url;
			if (!httpUrl(url) && !(event.isMainFrame === false && /^(about:blank|blob:|data:)/.test(url)))
				event.preventDefault();
		});
		contents.on('will-attach-webview', (event) => event.preventDefault());
		contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
			if (!mainFrame) return;
			tab.url = httpUrl(url) ? url : tab.url;
			tab.error = undefined;
			if (!inPlace) {
				tab.inspection++;
				tab.inspecting = false;
			}
			this.emit(tab);
		});
		contents.on('did-start-loading', () => this.emit(tab));
		contents.on('did-stop-loading', () => this.emit(tab));
		contents.on('page-title-updated', () => this.emit(tab));
		contents.on('did-navigate-in-page', () => this.emit(tab));
		contents.on('dom-ready', () => {
			void this.markers(tab).catch(() => {});
		});
		contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
			if (!mainFrame || code === -3) return;
			tab.error = `Could not load this page: ${description.slice(0, 300)} (${code}).`;
			this.emit(tab);
		});
		contents.on('render-process-gone', () => {
			tab.inspecting = false;
			tab.inspection++;
			tab.error = 'The browser page stopped responding. Reload to try again.';
			this.emit(tab);
		});
		contents.on('before-input-event', (event, input) => {
			if (input.type === 'keyDown' && input.key === 'Escape' && tab.inspecting) {
				event.preventDefault();
				void this.stopInspection(tab).then(() => this.emit(tab));
			}
		});
		contents.on('context-menu', (_event, params) => {
			Menu.buildFromTemplate([
				{ role: 'copy', enabled: !!params.selectionText },
				{ type: 'separator' },
				{ label: 'Reload', click: () => contents.reload() },
				{ label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) },
			]).popup({ window: this.window });
		});
		return tab;
	}

	private navigate(tab: BrowserTab, url: string) {
		tab.url = url;
		tab.error = undefined;
		void tab.view.webContents.loadURL(url).catch((error: Error) => {
			if (tab.view.webContents.isDestroyed() || /ERR_ABORTED/.test(error.message)) return;
			tab.error ??= `Could not load this page. ${error.message.slice(0, 300)}`;
			this.emit(tab);
		});
	}

	private state(tab: BrowserTab): CodeBrowserState {
		const contents = tab.view.webContents;
		if (contents.isDestroyed())
			return {
				tabId: tab.id,
				scope: tab.scope,
				url: tab.url,
				title: '',
				loading: false,
				canGoBack: false,
				canGoForward: false,
				visible: false,
				inspecting: false,
				error: 'This browser tab is closed.',
			};
		return {
			tabId: tab.id,
			scope: tab.scope,
			url: httpUrl(contents.getURL()) ? contents.getURL() : tab.url,
			title: contents.getTitle().slice(0, 500),
			loading: contents.isLoading(),
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
			visible: tab.visible,
			inspecting: tab.inspecting,
			...(tab.error ? { error: tab.error } : {}),
		};
	}

	private emit(tab: BrowserTab): CodeBrowserState {
		const state = this.state(tab);
		if (!this.disposed && this.tabs.get(tab.id) === tab && !this.window.isDestroyed())
			this.callbacks.onState(state);
		return state;
	}

	private hide(id?: string, except = false) {
		for (const tab of this.tabs.values()) {
			if (id && (except ? tab.id === id : tab.id !== id)) continue;
			if (!tab.visible && !tab.inspecting) continue;
			tab.visible = false;
			tab.view.setVisible(false);
			void this.stopInspection(tab);
			if (!tab.view.webContents.isDestroyed()) this.emit(tab);
		}
	}

	private async stopInspection(tab: BrowserTab) {
		tab.inspection++;
		tab.inspecting = false;
		if (tab.view.webContents.isDestroyed()) return;
		await tab.view.webContents
			.executeJavaScriptInIsolatedWorld(WORLD, [
				{
					code: 'globalThis.__freelmBrowserOverlay?.cancel();',
				},
			])
			.catch(() => {});
	}

	private inspect(tab: BrowserTab) {
		if (!tab.visible || !httpUrl(tab.view.webContents.getURL()))
			throw new Error('Open a visible page before selecting an element.');
		if (tab.inspecting) return;
		const generation = ++tab.inspection;
		tab.inspecting = true;
		void tab.view.webContents
			.executeJavaScriptInIsolatedWorld(WORLD, [
				{
					code: `${OVERLAY_SCRIPT}\nglobalThis.__freelmBrowserOverlay.select();`,
				},
			])
			.then((value: unknown) => {
				if (this.disposed || tab.inspection !== generation || this.tabs.get(tab.id) !== tab) return;
				tab.inspecting = false;
				this.emit(tab);
				if (value)
					this.callbacks.onElement({
						tabId: tab.id,
						scope: tab.scope,
						element: elementData(value),
					});
			})
			.catch(() => {
				if (this.disposed || tab.inspection !== generation || this.tabs.get(tab.id) !== tab) return;
				tab.inspecting = false;
				tab.error = 'Could not select this element. Reload the page and try again.';
				this.emit(tab);
			});
	}

	private async markers(tab: BrowserTab) {
		if (!httpUrl(tab.view.webContents.getURL()) || tab.view.webContents.isDestroyed()) return;
		await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [
			{
				code: `${OVERLAY_SCRIPT}\nglobalThis.__freelmBrowserOverlay.markers(${JSON.stringify(tab.annotations.map(({ id, element }) => ({ id, element })))}, ${tab.markersVisible});`,
			},
		]);
	}

	private close(tab: BrowserTab) {
		tab.inspection++;
		this.tabs.delete(tab.id);
		if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
		if (!tab.view.webContents.isDestroyed())
			tab.view.webContents.close({ waitForBeforeUnload: false });
		void tab.session.clearStorageData().catch(() => {});
	}

	private reset() {
		// A new app renderer cannot recover these view IDs. Release the old tabs
		// instead of letting reloads or crashes accumulate unreachable renderers.
		for (const tab of this.tabs.values()) this.close(tab);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.reset();
	}
}

// This fixed script runs in a dedicated isolated world, without a preload or IPC.
// Page text and selectors returned by it are untrusted metadata, never instructions.
const OVERLAY_SCRIPT = String.raw`
(() => {
  if (globalThis.__freelmBrowserOverlay) return;
  let annotations = [], visible = true, pending = null, hovered = null;
  const host = document.createElement('div');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({mode:'closed'});
  const layer = document.createElement('div'); shadow.append(layer);
  const highlight = document.createElement('div'); shadow.append(highlight);
  highlight.style.cssText = 'position:fixed;display:none;pointer-events:none;border:2px solid #588bff;background:rgba(88,139,255,.13);box-sizing:border-box;border-radius:3px;';
  const attach = () => { if (!host.isConnected) document.documentElement.append(host); };
  const samePage = (url) => { try { const a=new URL(url); const b=new URL(location.href); a.hash=''; b.hash=''; return a.href===b.href; } catch { return false; } };
  const draw = () => {
    attach(); layer.replaceChildren();
    if (!visible) return;
    annotations.forEach((annotation,index) => {
      if (!samePage(annotation.element.url)) return;
      let target; try { target=document.querySelector(annotation.element.selector); } catch {}
      const rect=target ? target.getBoundingClientRect() : annotation.element.rect;
      if (rect.x+rect.width<0 || rect.y+rect.height<0 || rect.x>innerWidth || rect.y>innerHeight) return;
      const marker=document.createElement('div'); marker.textContent=String(index+1);
      marker.style.cssText='position:fixed;display:grid;place-items:center;width:23px;height:23px;background:#316aff;color:white;border:2px solid white;box-shadow:0 2px 6px #0006;border-radius:50%;font:600 12px/1 system-ui;pointer-events:none;';
      marker.style.left=Math.max(0,Math.min(innerWidth-27,rect.x-10))+'px';
      marker.style.top=Math.max(0,Math.min(innerHeight-27,rect.y-10))+'px'; layer.append(marker);
    });
  };
  const selector = (element) => {
    const parts=[]; let node=element;
    for(let depth=0;node && node.nodeType===1 && depth<6;depth++,node=node.parentElement){
      if(node.id){ parts.unshift('#'+CSS.escape(node.id)); break; }
      let part=node.tagName.toLowerCase();
      const siblings=node.parentElement ? Array.from(node.parentElement.children).filter(x=>x.tagName===node.tagName) : [];
      if(siblings.length>1) part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0,2000);
  };
  const move = (event) => {
    if (!pending || !event.isTrusted) return;
    hovered=event.composedPath().find(node=>node instanceof Element && node!==host);
    if (!hovered) return;
    const rect=hovered.getBoundingClientRect(); highlight.style.display='block';
    Object.assign(highlight.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
  };
  const finish = (value) => {
    const resolve=pending; pending=null; hovered=null; highlight.style.display='none';
    window.removeEventListener('mousemove',move,true); window.removeEventListener('click',click,true);
    window.removeEventListener('pointerdown',suppress,true); window.removeEventListener('pointerup',click,true);
    // Canceling pointerdown can suppress Chromium's compatibility click entirely.
    // Select on pointerup and consume a following click if one is still emitted.
    if(value){
      const swallow=event=>{if(event.isTrusted){event.preventDefault();event.stopImmediatePropagation();window.removeEventListener('click',swallow,true);}};
      window.addEventListener('click',swallow,true);setTimeout(()=>window.removeEventListener('click',swallow,true),250);
    }
    if(resolve) resolve(value);
  };
  const suppress = (event) => { if(pending && event.isTrusted){event.preventDefault();event.stopImmediatePropagation();} };
  const click = (event) => {
    if(!pending || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const target=event.composedPath().find(node=>node instanceof Element && node!==host);
    if(!target) return;
    const rect=target.getBoundingClientRect();
    finish({tag:target.tagName.toLowerCase(),text:(target.innerText||target.getAttribute('aria-label')||target.getAttribute('alt')||'').replace(/\s+/g,' ').trim().slice(0,2000),selector:selector(target),url:location.href,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
  };
  window.addEventListener('scroll',draw,{capture:true,passive:true}); window.addEventListener('resize',draw,{passive:true});
  globalThis.__freelmBrowserOverlay={
    cancel:()=>finish(null),
    markers:(items,shown)=>{annotations=items;visible=shown;draw();},
    select:()=>{finish(null);attach();return new Promise(resolve=>{pending=resolve;window.addEventListener('mousemove',move,true);window.addEventListener('pointerdown',suppress,true);window.addEventListener('pointerup',click,true);window.addEventListener('click',click,true);});}
  };
})();`;
