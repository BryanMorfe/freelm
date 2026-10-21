/** The browser surface is local UI, not an agent tool or a privileged web-page bridge. */
export interface CodeBrowserBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CodeBrowserElement {
	tag: string;
	text: string;
	selector: string;
	url: string;
	/** Page viewport coordinates in CSS pixels, captured when selected. */
	rect: CodeBrowserBounds;
}

export interface CodeBrowserAnnotation {
	id: string;
	element: CodeBrowserElement;
	comment: string;
}

export interface CodeBrowserState {
	tabId: string;
	scope: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	visible: boolean;
	inspecting: boolean;
	error?: string;
}

export interface CodeBrowserSelection {
	tabId: string;
	scope: string;
	element: CodeBrowserElement;
}

export interface CodeBrowserScreenshot {
	dataUrl: string;
	width: number;
	height: number;
	url: string;
	title: string;
}

export type CodeBrowserRequest =
	| { action: 'open'; tabId: string; scope: string; url?: string }
	| { action: 'show'; tabId: string; bounds: CodeBrowserBounds }
	| { action: 'hide'; tabId?: string }
	| { action: 'navigate'; tabId: string; url: string }
	| { action: 'inspect'; tabId: string; enabled?: boolean }
	| {
			action: 'annotations';
			tabId: string;
			annotations: CodeBrowserAnnotation[];
			visible: boolean;
	  }
	| {
			action: 'back' | 'forward' | 'reload' | 'close' | 'state' | 'capture' | 'devtools';
			tabId: string;
	  };

export interface CodeBrowserResult {
	state?: CodeBrowserState;
	screenshot?: CodeBrowserScreenshot;
}
